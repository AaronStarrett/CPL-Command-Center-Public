import { describe, expect, it } from "vitest";

import { resolveWebLoggingConfiguration } from "../../apps/web/lib/web-logging-config";

describe("web logging configuration", () => {
  it("uses the validated repository environment", () => {
    expect(
      resolveWebLoggingConfiguration(() => ({
        environment: { nodeEnv: "development", logLevel: "silent" },
      })),
    ).toEqual({ environment: "development", level: "silent", usedSafeFallback: false });
  });

  it("uses safe non-sensitive defaults when repository environment loading fails", () => {
    expect(
      resolveWebLoggingConfiguration(() => {
        throw new Error("sensitive bootstrap detail");
      }),
    ).toEqual({ environment: "unknown", level: "info", usedSafeFallback: true });
  });
});
