import { describe, expect, it, vi } from "vitest";
import {
  createCplWorkerFetch,
  directWorkerResponse,
  isWorkspaceDocument,
} from "../../apps/web/lib/cloudflare-dispatch";
import { NextResponse } from "../../apps/web/lib/cloudflare-next-response.mjs";

const origin = "https://workspace.example.test";
const asset = "/cdn-cgi/cpl-shell/synthetic-build/workspace.html";
function fixture() {
  const session = vi.fn(async () =>
    Response.json(
      { authenticated: false },
      {
        headers: { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" },
      },
    ),
  );
  const signIn = vi.fn(
    async () =>
      new Response(null, { status: 303, headers: { Location: "https://accounts.example.test" } }),
  );
  const get = vi.fn(async (_request: Request, context: { params: Promise<{ path: string[] }> }) =>
    Response.json(await context.params),
  );
  const post = vi.fn(async () => Response.json({ created: true }, { status: 201 }));
  const fallback = vi.fn(async () => new Response("Next fallback", { status: 202 }));
  const runWithContext = vi.fn(async (_request, _env, _context, operation) => operation());
  const assets = vi.fn(async () => new Response("<html>Generated shell</html>"));
  const env = { NODE_ENV: "production", CPL_HOSTED_ENABLED: "true", ASSETS: { fetch: assets } };
  const context = { requestMarker: "real-context" };
  const fetch = createCplWorkerFetch({
    auth: { "/api/auth/session": { GET: session }, "/api/auth/google/start": { POST: signIn } },
    cpl: { GET: get, POST: post },
    workspaceAsset: asset,
    fallback,
    runWithContext,
  });
  return { fetch, env, context, session, signIn, get, post, fallback, runWithContext, assets };
}
const request = (path: string, init?: RequestInit) => new Request(origin + path, init);

describe("direct hosted Worker transport", () => {
  it("preserves the public redirect and clears its query without entering Next or auth", async () => {
    const f = fixture();
    const response = await f.fetch(request("/?untrusted=target"), f.env, f.context);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(origin + "/workspace");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.runWithContext).not.toHaveBeenCalled();
  });
  it.each(["/api/leads", "/api/cpl/unknown", "/api/cpl/leads/", "/api/cpl/%77orkspace"])(
    "keeps the shared fail-closed policy for %s",
    async (path) => {
      const f = fixture();
      const response = await f.fetch(request(path), f.env, f.context);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "CPL_PRODUCT_RUNTIME_NOT_READY" });
      expect(f.get).not.toHaveBeenCalled();
      expect(f.fallback).not.toHaveBeenCalled();
    },
  );
  it("disabled hosting cannot dispatch an otherwise released auth route", async () => {
    const f = fixture();
    const response = await f.fetch(
      request("/api/auth/session"),
      { ...f.env, CPL_HOSTED_ENABLED: "false" },
      f.context,
    );
    expect(response.status).toBe(503);
    expect(f.session).not.toHaveBeenCalled();
  });
  it("test policy allowances cannot activate production handlers", async () => {
    const f = fixture();
    expect(
      (await f.fetch(request("/api/auth/session"), { ...f.env, NODE_ENV: "test" }, f.context))
        .status,
    ).toBe(202);
    expect(f.session).not.toHaveBeenCalled();
  });
  it("calls the existing session handler once with the real request context and no default Next handler", async () => {
    const f = fixture();
    const incoming = request("/api/auth/session", { headers: { cookie: "opaque=unchanged" } });
    const response = await f.fetch(incoming, f.env, f.context);
    expect(f.session).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(f.runWithContext).toHaveBeenCalledWith(incoming, f.env, f.context, expect.any(Function));
    expect(f.fallback).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });
  it("delegates CPL context and mutation bodies without choosing a tenant or replaying the handler", async () => {
    const f = fixture();
    const incoming = request("/api/cpl/leads/0123-abcd?organization=untrusted");
    expect(await (await f.fetch(incoming, f.env, f.context)).json()).toEqual({
      path: ["leads", "0123-abcd"],
    });
    expect(f.get).toHaveBeenCalledExactlyOnceWith(incoming, expect.any(Object));
    const mutation = request("/api/cpl/leads", {
      method: "POST",
      headers: { origin: "https://wrong.example.test" },
      body: "unchanged",
    });
    expect((await f.fetch(mutation, f.env, f.context)).status).toBe(201);
    expect(f.post).toHaveBeenCalledExactlyOnceWith(mutation, expect.any(Object));
    expect(await mutation.text()).toBe("unchanged");
  });
  it("preserves Next's automatic HEAD, OPTIONS and unsupported-method responses", async () => {
    const f = fixture();
    const head = await f.fetch(request("/api/auth/session", { method: "HEAD" }), f.env, f.context);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(f.session).toHaveBeenCalledOnce();
    const options = await f.fetch(
      request("/api/cpl/leads", { method: "OPTIONS" }),
      f.env,
      f.context,
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect((await f.fetch(request("/api/auth/google/start"), f.env, f.context)).status).toBe(405);
    expect(f.signIn).not.toHaveBeenCalled();
  });
  it("does not fall back and accidentally repeat an operation when a handler throws", async () => {
    const f = fixture();
    f.session.mockRejectedValueOnce(new Error("synthetic failure"));
    await expect(f.fetch(request("/api/auth/session"), f.env, f.context)).rejects.toThrow(
      "synthetic failure",
    );
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("preserves every real NextResponse cookie while stripping script-readable internal mirrors", async () => {
    const next = NextResponse.json({ ok: true });
    next.cookies.set("__Host-cpl-session", "synthetic-session", {
      secure: true,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    next.cookies.set("__Host-cpl-csrf", "synthetic-csrf", {
      secure: true,
      path: "/",
      sameSite: "strict",
    });
    next.cookies.set("__Host-cpl-oauth", "", {
      secure: true,
      httpOnly: true,
      path: "/",
      maxAge: 0,
    });
    next.headers.set("x-middleware-override-headers", "synthetic");
    const before = next.headers.getSetCookie();
    expect(next.headers.has("x-middleware-set-cookie")).toBe(true);
    const response = await directWorkerResponse(next, "POST");
    expect(response.headers.getSetCookie()).toEqual(before);
    expect(before).toHaveLength(3);
    expect(before[0]).toContain("HttpOnly");
    expect([...response.headers.keys()].some((key) => key.startsWith("x-middleware-"))).toBe(false);
  });
  it("serves only the exact generated public shell and preserves HEAD/security headers", async () => {
    const f = fixture();
    const response = await f.fetch(request("/workspace?view=public"), f.env, f.context);
    expect(await response.text()).toBe("<html>Generated shell</html>");
    expect(f.assets.mock.calls[0]?.[0].url).toBe(origin + asset);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(f.fallback).not.toHaveBeenCalled();
    expect(
      await (await f.fetch(request("/workspace", { method: "HEAD" }), f.env, f.context)).text(),
    ).toBe("");
  });
  it.each(["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"])(
    "leaves %s rendering requests to OpenNext",
    async (header) => {
      const f = fixture();
      const incoming = request("/workspace", { headers: { [header]: "1" } });
      expect(isWorkspaceDocument(incoming)).toBe(false);
      expect((await f.fetch(incoming, f.env, f.context)).status).toBe(202);
      expect(f.assets).not.toHaveBeenCalled();
    },
  );
  it("leaves Flight query requests and missing assets to OpenNext without inventing HTML", async () => {
    const f = fixture();
    expect((await f.fetch(request("/workspace?_rsc=1"), f.env, f.context)).status).toBe(202);
    f.assets.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    expect((await f.fetch(request("/workspace"), f.env, f.context)).status).toBe(202);
    expect(f.fallback).toHaveBeenCalledTimes(2);
  });
});
