import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const uiCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
const commandCss = readFileSync(
  resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
  "utf8",
);
const cockpit = readFileSync(
  resolve(process.cwd(), "apps/web/components/ai-command-motion-workspace.tsx"),
  "utf8",
);

describe("calm tile motion", () => {
  it("never applies perspective, rotation, or large scale to primary tiles", () => {
    expect(uiCss).not.toMatch(/\.bea-card:hover[\s\S]{0,200}perspective\(/u);
    expect(uiCss).not.toMatch(/\.bea-card:hover[\s\S]{0,200}rotateX\(/u);
    expect(commandCss).not.toMatch(/perspective:\s*100rem/u);
    expect(commandCss).not.toMatch(/rotateX\(var\(--bea-tile-rotate-x\)\)/u);
    expect(cockpit).not.toContain("--bea-tile-rotate-x");
    expect(cockpit).not.toMatch(/\(0\.5 - normalizedY\) \* 1\.4/u);
  });

  it("limits hover to a two-pixel lift and respects reduced motion", () => {
    expect(uiCss).toContain("--bea-motion-hover-lift: -2px");
    expect(uiCss).toContain("--bea-motion-pointer-tilt-range: 0deg");
    expect(commandCss).toMatch(
      /:global\(:root\[data-motion-profile="reduced"\]\) \.panel,[\s\S]*?transform:\s*none !important;/u,
    );
  });
});
