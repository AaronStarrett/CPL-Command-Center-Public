import { describe, expect, it } from "vitest";

import { safeReturnPath } from "../../apps/web/lib/safe-return-path";

describe("safeReturnPath", () => {
  it.each([
    "//evil.example/path",
    "/\\evil.example/path",
    "/\t/evil.example",
    "/\r\n/evil.example",
    "/%2f%2fevil.example/path",
    "/%5cevil.example/path",
    "/%09/evil.example",
    "/%0d%0a/evil.example",
    "/%252f%252fevil.example/path",
    "/%255cevil.example/path",
    "/.//evil.example",
    "/%2e//evil.example",
    "/%2e%2e//evil.example",
  ])("rejects unsafe raw or encoded return target %s", (candidate) => {
    expect(safeReturnPath(candidate, "/safe", "https://command-center.example.invalid")).toBe(
      "/safe",
    );
  });

  it("normalizes a valid same-origin path, query, and fragment", () => {
    expect(
      safeReturnPath(
        "/account/../account?tab=session#expiry",
        "/",
        "https://command-center.example.invalid",
      ),
    ).toBe("/account?tab=session#expiry");
  });
});
