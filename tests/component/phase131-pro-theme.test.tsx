import { SYNTHETIC_EXECUTIVE_PROFILE as DEFAULT_EXECUTIVE_PROFILE } from "../fixtures/executive-profile";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { ExecutiveProfileAdministrationPanel } from "../../apps/web/components/executive-profile-administration";
import {
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
} from "../../packages/domain/src/index";

describe("Phase 1.3 pro-glass cockpit and persona preservation contracts", () => {
  it("centralizes the light clear-glass shell and two-panel visual tokens", () => {
    const shellCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    expect(shellCss).toMatch(/--bea-pro-atmosphere:/u);
    expect(shellCss).toMatch(/--bea-pro-glass-surface:\s*rgb\([^;]+\/\s*61%\)/u);
    expect(shellCss).toMatch(/--bea-pro-glass-blur:\s*1\.35rem/u);
    expect(shellCss).toMatch(/\.bea-application-shell__topbar\s*\{[\s\S]*?backdrop-filter:/u);
    expect(shellCss).toMatch(/\.bea-application-shell__sidebar\s*\{[\s\S]*?backdrop-filter:/u);
  });

  it("publishes the two seamless tiles, dominant orb, wide fade stream, and one scroller per tile", () => {
    const cockpitCss = readFileSync(
      resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
      "utf8",
    );
    const cockpitSource = readFileSync(
      resolve(process.cwd(), "apps/web/components/ai-command-motion-workspace.tsx"),
      "utf8",
    );
    expect(cockpitCss).toMatch(
      /\/\* Phase 1\.3\.2:[\s\S]*?--bea-orb-diameter:\s*clamp\(15rem, 33vh, 26\.875rem\)/u,
    );
    expect(cockpitCss).toMatch(
      /\.panel\s*\{[\s\S]*?backdrop-filter:\s*blur\(1\.65rem\) saturate\(132%\)/u,
    );
    expect(cockpitCss).toMatch(
      /\.messages\s*\{[\s\S]*?mask-image:\s*linear-gradient\(\s*to bottom,[\s\S]*?#000 100%\s*\)/u,
    );
    expect(cockpitCss).toMatch(
      /\.messages \.message\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;[\s\S]*?width:\s*min\(92%, 48rem\)/u,
    );
    expect(cockpitCss).toMatch(
      /\.composer\s*\{[\s\S]*?align-self:\s*end;[\s\S]*?border-top:[\s\S]*?grid-row:\s*2/u,
    );
    expect(cockpitCss).toMatch(
      /\.workspaceBody\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto/u,
    );
    expect(cockpitSource.match(/data-primary-glass-tile=/gu)).toHaveLength(2);
    expect(cockpitSource).toContain('data-testid="ai-command-progressive-controls"');
    expect(cockpitSource).not.toContain('data-testid="ai-capability-launcher"');
    expect(cockpitSource).not.toContain("Lead Intake");
    expect(cockpitSource).not.toContain("Proposal Builder");
    expect(cockpitSource).not.toContain("Project Creation");
    expect(cockpitSource).not.toContain("Market Insights");
  });

  it("uses Command Center as the no-return login destination while preserving safe deep links", () => {
    const route = readFileSync(
      resolve(process.cwd(), "apps/web/app/api/auth/sign-in/route.ts"),
      "utf8",
    );
    const page = readFileSync(resolve(process.cwd(), "apps/web/app/sign-in/page.tsx"), "utf8");
    expect(route).toContain('safeReturnPath(formData.get("returnTo"), "/command-center"');
    expect(page).toContain('redirect("/command-center")');
    expect(page).toContain('name="returnTo" value={returnTo}');
  });

  it("renders owner-only profile provenance, prompt versions, and deterministic theme preview", () => {
    const activeProfile = DEFAULT_EXECUTIVE_PROFILE.versions.find(
      (version) => version.version === DEFAULT_EXECUTIVE_PROFILE.activeVersion,
    );
    expect(activeProfile).toBeDefined();
    render(
      <ExecutiveProfileAdministrationPanel
        initial={{
          profile: DEFAULT_EXECUTIVE_PROFILE,
          activeProfile: activeProfile!,
          profileSettingVersion: 1,
          personaPolicy: DEFAULT_EXECUTIVE_PERSONA_POLICY,
          personaSettingVersion: 1,
          brandPolicy: DEFAULT_ARTIFACT_BRAND_POLICY,
          preview: "Jordan, my recommendation is to prioritize the highest-impact next action.",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Executive Profile" })).toBeVisible();
    expect(screen.getByDisplayValue("Jordan Example")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Open reference" })[0]).toHaveAttribute(
      "rel",
      expect.stringContaining("noopener"),
    );
    expect(screen.getByRole("combobox", { name: "Prompt version" })).toHaveValue(
      DEFAULT_EXECUTIVE_PERSONA_POLICY.activeVersion,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview persona" }));
    expect(screen.getByText(/Jordan, my recommendation/iu)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview CPL theme" }));
    expect(screen.getByTestId("bea-brand-policy-preview")).toBeVisible();
    expect(screen.getByRole("img", { name: "Cyber Pirate Labs" })).toHaveAttribute(
      "src",
      "/brand/cpl-logo.png",
    );
  });
});
