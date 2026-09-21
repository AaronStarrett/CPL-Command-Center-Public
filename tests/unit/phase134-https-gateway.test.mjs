import { describe, expect, it } from "vitest";

import {
  buildForwardHeaders,
  normalizeExpectedHost,
} from "../../scripts/phase134/https-gateway.mjs";

describe("Phase 1.3.4 HTTPS gateway contracts", () => {
  it("accepts only a loopback-resolving .localhost hostname", () => {
    expect(normalizeExpectedHost("bea.localhost", 3443)).toBe("bea.localhost:3443");
    expect(() => normalizeExpectedHost("bea.example.com", 3443)).toThrow(/\.localhost/u);
    expect(() => normalizeExpectedHost("localhost.evil.example", 3443)).toThrow(/\.localhost/u);
  });

  it("replaces untrusted host and forwarding headers without dropping cookies or SSE", () => {
    expect(
      buildForwardHeaders(
        {
          accept: "text/event-stream",
          connection: "keep-alive",
          cookie: "bea_session=opaque",
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
        },
        "bea.localhost:3443",
        3210,
      ),
    ).toEqual({
      accept: "text/event-stream",
      cookie: "bea_session=opaque",
      host: "127.0.0.1:3210",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "bea.localhost:3443",
      "x-forwarded-proto": "https",
    });
  });
});
