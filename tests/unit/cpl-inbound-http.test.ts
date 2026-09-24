import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inboundAddressKey,
  inboundBytes,
  inboundPublicId,
  requireInquiryOrigin,
  signedInboundHeaders,
  CPL_INBOUND_BODY_TIMEOUT_MS,
} from "../../apps/web/lib/cpl-inbound-http";
import {
  integrationCallbackQuery,
  integrationFailure,
  integrationList,
} from "../../apps/web/lib/cpl-integration-http";
import { assertNoLocalDevelopmentConfiguration } from "../../scripts/local-development-policy.mjs";
import { cplEntryDecision } from "../../apps/web/lib/cpl-entry-policy";

const origin = "http://127.0.0.1:3400";
const request = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
  new Request(origin + "/api/cpl-inbound/forms/" + "a".repeat(32), {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: body as BodyInit,
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("anonymous inbound HTTP boundary", () => {
  it("retains exact UTF-8 bytes for signature verification instead of reserializing JSON", async () => {
    const raw =
      ' { "eventId": "synthetic-event", "values": { "details": "<script>hostile</script> — café" } }\n';
    expect(new TextDecoder().decode(await inboundBytes(request(raw)))).toBe(raw);
  });
  it("enforces actual streaming size even when length is omitted or understated", async () => {
    await expect(inboundBytes(request("x".repeat(65_537)))).rejects.toThrow();
    await expect(
      inboundBytes(request("x".repeat(65_537), { "content-length": "1" })),
    ).rejects.toThrow();
  });
  it("cancels a stalled anonymous body within the total read deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const incoming = new Request(origin + "/api/cpl-inbound/forms/" + "a".repeat(32), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ start() {}, cancel }),
      duplex: "half",
    } as RequestInit);
    const result = inboundBytes(incoming).catch((error) => error);
    await vi.advanceTimersByTimeAsync(CPL_INBOUND_BODY_TIMEOUT_MS);
    const error = await result;
    expect(error.code).toBe("CPL_INBOUND_TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(integrationFailure(error, true).status).toBe(408);
  });
  it.each(["text/plain", "multipart/form-data", "application/json; charset=iso-8859-1"])(
    "rejects unsupported content type %s",
    async (type) => {
      await expect(inboundBytes(request("{}", { "content-type": type }))).rejects.toThrow();
    },
  );
  it("accepts only the exact configured browser origin, independent of forwarded headers", () => {
    expect(() => requireInquiryOrigin(request("{}"), origin)).not.toThrow();
    expect(() =>
      requireInquiryOrigin(
        request("{}", { origin: "https://attacker.invalid", "x-forwarded-host": "127.0.0.1:3400" }),
        origin,
      ),
    ).toThrow();
    expect(() =>
      requireInquiryOrigin(request("{}", { "sec-fetch-site": "cross-site" }), origin),
    ).toThrow();
  });
  it("untrusted IP headers cannot buy additional anonymous rate buckets", () => {
    const first = inboundAddressKey(
      request("{}", { "x-forwarded-for": "192.0.2.1", "cf-connecting-ip": "192.0.2.2" }),
    );
    const second = inboundAddressKey(request("{}", { "x-forwarded-for": "198.51.100.1" }));
    expect(first).toBe("unattributed");
    expect(second).toBe(first);
  });
  it("rejects traversal and duplicate signature header values", () => {
    expect(() => inboundPublicId("../private")).toThrow();
    const headers = {
      "x-cpl-source-key": "a".repeat(32),
      "x-cpl-timestamp": "1790000000",
      "x-cpl-nonce": "b".repeat(32),
      "x-cpl-signature": "c".repeat(43),
    };
    expect(signedInboundHeaders(request("{}", headers)).keyId).toBe(headers["x-cpl-source-key"]);
    expect(() =>
      signedInboundHeaders(
        request("{}", { ...headers, "x-cpl-source-key": "a".repeat(32) + "," + "b".repeat(32) }),
      ),
    ).toThrow();
  });
  it("returns only public conflict/rate outcomes with no tenant/source details", async () => {
    const error = {
      code: "CPL_INTEGRATION_SOURCE_CONFLICT",
      message: "secret mailbox body",
      organizationId: "tenant-private",
    };
    const response = integrationFailure(error, true);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CPL_INBOUND_CONFLICT" });
    const throttled = integrationFailure({ code: "CPL_INTEGRATION_RATE_LIMITED" }, true);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("60");
    expect(throttled.headers.get("Cache-Control")).toContain("no-store");
  });
  it("unknown failures expose/log only a correlation reference", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = integrationFailure(
      { code: "evil-token", message: "secret mailbox body", cause: "postgresql://secret" },
      true,
    );
    expect(response.status).toBe(503);
    const result = await response.json();
    expect(result.correlationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify([result, log.mock.calls])).not.toMatch(/evil-token|secret|postgresql/u);
  });
});

describe("integration route and release boundaries", () => {
  it("rejects callback tenant claims, duplicate state and ambiguous code/error", () => {
    const callback = (query: string) =>
      new Request(origin + "/api/cpl-integrations/oauth/google/callback?" + query);
    expect(integrationCallbackQuery(callback("state=fixture-state&code=fixture-code"))).toEqual({
      state: "fixture-state",
      code: "fixture-code",
    });
    for (const query of [
      "state=a&state=b&code=c",
      "state=a&code=c&error=denied",
      "state=a&code=c&organizationId=other",
      "state=a",
    ])
      expect(() => integrationCallbackQuery(callback(query))).toThrow();
  });
  it("does not silently accept company claims or unbounded list parameters", () => {
    expect(() => integrationList(new Request(origin + "/?organizationId=other"))).toThrow();
    expect(() => integrationList(new Request(origin + "/?limit=999"))).toThrow();
    expect(() => integrationList(new Request(origin + "/?cursor=a&cursor=b"))).toThrow();
  });
  it("production gates reject local integration configuration even without local auth flags", () => {
    for (const configuration of [
      { CPL_LOCAL_INTEGRATION_MATERIAL: "" },
      { CPL_INTEGRATION_PROVIDER_MODE: "local_fixture" },
    ])
      expect(() => assertNoLocalDevelopmentConfiguration(configuration)).toThrow(
        "CPL_LOCAL_DEVELOPMENT_PRODUCTION_REFUSED",
      );
    expect(() =>
      assertNoLocalDevelopmentConfiguration({ CPL_INTEGRATION_PROVIDER_MODE: "live" }),
    ).not.toThrow();
  });
  it("route allowlist exposes only concrete integration and inquiry paths", () => {
    for (const route of [
      "/api/cpl-integrations/workspace",
      "/api/cpl-integrations/oauth/google/callback",
      "/api/cpl-inbound/forms/" + "a".repeat(32),
      "/inquiry/" + "a".repeat(32),
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
    for (const route of [
      "/api/cpl-integrations/secrets",
      "/api/cpl-inbound/admin",
      "/api/integrations/gmail",
    ])
      expect(cplEntryDecision(route, "POST", "development", false, true)).toBe("unavailable");
  });
});
