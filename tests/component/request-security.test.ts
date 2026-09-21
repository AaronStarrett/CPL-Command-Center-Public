import { afterEach, describe, expect, it } from "vitest";

import {
  hasJsonMutationBody,
  isSameOriginRequest,
  isStrictSameOriginMutation,
  validateBodylessMutation,
  validateBoundedJsonMutation,
} from "../../apps/web/lib/request-security";

const originalAppBaseUrl = process.env.APP_BASE_URL;

function request(url: string, origin: string | null) {
  return {
    url,
    headers: new Headers(origin ? { Origin: origin } : undefined),
  } as Parameters<typeof isSameOriginRequest>[0];
}

afterEach(() => {
  if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalAppBaseUrl;
});

describe("same-origin request validation", () => {
  it("accepts the configured public origin when Next reconstructs another host", () => {
    process.env.APP_BASE_URL = "http://127.0.0.1:3000";
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/auth/sign-in", "http://127.0.0.1:3000"),
      ),
    ).toBe(true);
  });

  it("accepts the request origin and requests without an Origin header", () => {
    delete process.env.APP_BASE_URL;
    expect(
      isSameOriginRequest(request("https://bea.example/api/auth/sign-in", "https://bea.example")),
    ).toBe(true);
    expect(isSameOriginRequest(request("https://bea.example/api/auth/sign-in", null))).toBe(true);
  });

  it("rejects foreign and malformed origins", () => {
    process.env.APP_BASE_URL = "https://bea.example";
    expect(
      isSameOriginRequest(request("https://bea.internal/api/auth/sign-in", "https://evil.example")),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request("https://bea.example/api/auth/sign-in", "https://bea.example/path"),
      ),
    ).toBe(false);
    expect(isSameOriginRequest(request("https://bea.example/api/auth/sign-in", "null"))).toBe(
      false,
    );
  });

  it("does not trust the reconstructed request host when a public origin is configured", () => {
    process.env.APP_BASE_URL = "https://bea.example";
    expect(
      isSameOriginRequest(
        request("https://poisoned-host.example/api/auth/sign-in", "https://poisoned-host.example"),
      ),
    ).toBe(false);
  });

  it("requires an explicit same-origin signal for strict AI mutations", () => {
    expect(
      isStrictSameOriginMutation(
        new Request("https://bea.example/api/ai-command/messages", {
          method: "POST",
          headers: { Origin: "https://bea.example", "Sec-Fetch-Site": "same-origin" },
        }),
        "https://bea.example",
      ),
    ).toBe(true);
    expect(
      isStrictSameOriginMutation(
        new Request("https://bea.example/api/ai-command/messages", { method: "POST" }),
        "https://bea.example",
      ),
    ).toBe(false);
  });
});

describe("strict bounded JSON mutation transport", () => {
  it("requires finite Content-Length before buffering JSON", () => {
    const missing = new Request("https://bea.example/api/ai-command/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(validateBoundedJsonMutation(missing)).toMatchObject({
      ok: false,
      code: "content-length-required",
      status: 411,
    });
    const ambiguous = new Request("https://bea.example/api/ai-command/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "5",
        "Transfer-Encoding": "chunked",
      },
    });
    expect(validateBoundedJsonMutation(ambiguous)).toMatchObject({
      ok: false,
      code: "ambiguous-request-body",
      status: 400,
    });
  });

  it("rejects oversized or non-JSON mutation bodies before parsing", () => {
    const oversized = new Request("https://bea.example/api/integrations/ai/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1024 + 1),
      },
    });
    expect(validateBoundedJsonMutation(oversized)).toMatchObject({
      ok: false,
      code: "request-body-too-large",
      status: 413,
    });
    const wrongType = new Request("https://bea.example/api/ai-command/tools/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Content-Length": "2" },
      body: "{}",
    });
    expect(validateBoundedJsonMutation(wrongType)).toMatchObject({
      ok: false,
      code: "unsupported-content-type",
      status: 415,
    });
  });

  it("accepts only bounded application JSON and rejects bodies on action-only routes", () => {
    const valid = new Request("https://bea.example/api/ai-command/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "2",
      },
      body: "{}",
    });
    expect(validateBoundedJsonMutation(valid)).toEqual({ ok: true, contentLength: 2 });
    expect(
      validateBodylessMutation(
        new Request("https://bea.example/api/integrations/ai/activate", { method: "POST" }),
      ),
    ).toEqual({ ok: true, contentLength: 0 });
    expect(validateBodylessMutation(valid)).toMatchObject({
      ok: false,
      code: "unexpected-request-body",
      status: 400,
    });
  });

  it("accepts empty POST bodies that Node exposes as a stream with Content-Length 0", () => {
    const empty = new Request("https://bea.example/api/integrations/ai/verify", {
      method: "POST",
      headers: { "Content-Length": "0" },
      body: "",
    });
    expect(empty.body).not.toBeNull();
    expect(hasJsonMutationBody(empty)).toBe(false);
    expect(validateBodylessMutation(empty)).toEqual({ ok: true, contentLength: 0 });
  });
});
