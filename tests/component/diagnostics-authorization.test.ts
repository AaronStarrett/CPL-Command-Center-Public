import { describe, expect, it, vi } from "vitest";

import {
  canIncludeApiDiagnostics,
  type DiagnosticsAuthorizationRuntime,
} from "../../apps/web/lib/diagnostics-authorization";

function runtimeWithDecision(decision: Promise<{ allowed: boolean }>) {
  return {
    authorization: {
      authorizeUser: vi.fn(() => decision),
    },
  } satisfies DiagnosticsAuthorizationRuntime;
}

describe("API diagnostics authorization", () => {
  it("requires an authenticated user and runtime", async () => {
    await expect(canIncludeApiDiagnostics(undefined, undefined)).resolves.toBe(false);
    await expect(
      canIncludeApiDiagnostics(runtimeWithDecision(Promise.resolve({ allowed: true })), undefined),
    ).resolves.toBe(false);
  });

  it("returns the database-backed administration decision", async () => {
    const runtime = runtimeWithDecision(Promise.resolve({ allowed: true }));

    await expect(canIncludeApiDiagnostics(runtime, "user-id")).resolves.toBe(true);
    expect(runtime.authorization.authorizeUser).toHaveBeenCalledWith(
      "user-id",
      "administration.view",
    );
  });

  it("fails closed when authorization storage fails", async () => {
    const runtime = runtimeWithDecision(Promise.reject(new Error("database unavailable")));

    await expect(canIncludeApiDiagnostics(runtime, "user-id")).resolves.toBe(false);
  });
});
