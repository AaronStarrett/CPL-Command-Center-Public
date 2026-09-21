import { describe, expect, it } from "vitest";

import { apiException } from "../../apps/web/lib/api-response";

describe("API exception responses", () => {
  it("keeps diagnostics out of responses without an authorized administration decision", async () => {
    const response = apiException(
      new Error("private database detail"),
      500,
      "correlation-safe",
      false,
    );
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.headers.get("X-Correlation-ID")).toBe("correlation-safe");
    expect(body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      correlationId: "correlation-safe",
    });
    expect(body.error).not.toHaveProperty("diagnostics");
  });

  it("includes bounded diagnostics only when the caller has already been authorized", async () => {
    const response = apiException(
      new Error("private diagnostic detail"),
      500,
      "correlation-admin",
      true,
    );
    const body = (await response.json()) as {
      error: { diagnostics?: { errorName: string; errorCode: string } };
    };

    expect(body.error.diagnostics).toEqual({
      errorName: "Error",
      errorCode: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(body)).not.toContain("private diagnostic detail");
  });
});
