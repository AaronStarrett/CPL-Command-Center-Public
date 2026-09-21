import { describe, expect, it } from "vitest";

import { parseWorkerHealthResponse } from "../../apps/web/lib/worker-health";

const fallbackCheckedAt = "2026-08-18T00:00:00.000Z";
const workerCheckedAt = "2026-08-18T00:01:00.000Z";

describe("worker health contract", () => {
  it("accepts a healthy worker response", () => {
    expect(
      parseWorkerHealthResponse(
        200,
        { service: "bea-worker", status: "healthy", checkedAt: workerCheckedAt },
        fallbackCheckedAt,
      ),
    ).toEqual({ status: "healthy", checkedAt: workerCheckedAt });
  });

  it.each(["degraded", "unhealthy"] as const)(
    "preserves a truthful %s worker response served with 503",
    (status) => {
      expect(
        parseWorkerHealthResponse(
          503,
          { service: "bea-worker", status, checkedAt: workerCheckedAt },
          fallbackCheckedAt,
        ),
      ).toEqual({ status, checkedAt: workerCheckedAt });
    },
  );

  it.each([
    [200, { service: "foreign-worker", status: "healthy" }],
    [200, { service: "bea-worker", status: "degraded" }],
    [503, { service: "bea-worker", status: "starting" }],
    [200, "not-an-object"],
  ])("maps a malformed or foreign response to unavailable", (httpStatus, body) => {
    expect(parseWorkerHealthResponse(httpStatus, body, fallbackCheckedAt)).toEqual({
      status: "unavailable",
      checkedAt: fallbackCheckedAt,
    });
  });
});
