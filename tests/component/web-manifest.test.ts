import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("web local-network boundary", () => {
  it("binds development and built servers to IPv4 loopback", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "apps/web/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts.dev).toContain("--hostname 127.0.0.1");
    expect(manifest.scripts.start).toContain("--hostname 127.0.0.1");
    expect(manifest.scripts.dev).not.toContain("0.0.0.0");
    expect(manifest.scripts.start).not.toContain("0.0.0.0");
    expect(manifest.scripts.typecheck).toBe(
      "node ../../scripts/next-no-env.mjs typegen && tsc --noEmit",
    );
  });
});
