import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { DesktopNavigation } from "../../apps/web/components/navigation";
import type { CommandCenterNavigationItem } from "../../apps/web/lib/navigation";
import { setTestPathname } from "./stubs/next-navigation";

const primaryItems: readonly CommandCenterNavigationItem[] = [
  {
    href: "/command-center",
    label: "Command Center",
    shortLabel: "Command",
    permission: "home.view",
  },
  {
    href: "/automation-flow",
    label: "Automation Flow",
    shortLabel: "Flow",
    permission: "home.view",
  },
  {
    href: "/company-details",
    label: "Company Details",
    shortLabel: "Company",
    permission: "home.view",
  },
];

const allLabels = [
  "Search",
  "Companies",
  "Contacts",
  "Tasks",
  "Activities",
  "Notifications",
  "AI Command",
  "Integrations",
  "Workflow Runs",
  "Audit",
  "Administration",
] as const;

const paths: Readonly<Record<(typeof allLabels)[number], string>> = {
  Search: "/search",
  Companies: "/companies",
  Contacts: "/contacts",
  Tasks: "/tasks",
  Activities: "/activities",
  Notifications: "/notifications",
  "AI Command": "/ai-command",
  Integrations: "/integrations",
  "Workflow Runs": "/workflow-runs",
  Audit: "/audit",
  Administration: "/administration",
};

function navigationItems(
  labels: readonly (typeof allLabels)[number][],
): readonly CommandCenterNavigationItem[] {
  return labels.map((label) => ({
    href: paths[label],
    label,
    shortLabel: label.slice(0, 2).toLocaleUpperCase("en-US"),
    permission: `${paths[label].slice(1)}.view` as CommandCenterNavigationItem["permission"],
  }));
}

const personaNavigation = [
  { name: "Workspace Owner", visible: allLabels },
  {
    name: "Sales Specialist",
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
    ],
  },
  {
    name: "Operations Coordinator",
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
      "Workflow Runs",
    ],
  },
  {
    name: "Executive Viewer",
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
    ],
  },
  {
    name: "Integration Administrator",
    visible: ["Search", "AI Command", "Integrations", "Administration"],
  },
] as const satisfies readonly {
  name: string;
  visible: readonly (typeof allLabels)[number][];
}[];

afterEach(() => {
  cleanup();
  setTestPathname("/");
});

describe("permission-filtered persona navigation", () => {
  it("renders exactly three primary destinations", () => {
    setTestPathname("/command-center");
    render(<DesktopNavigation primary={primaryItems} secondary={navigationItems(allLabels)} />);
    const navigation = screen.getByRole("navigation", { name: "Command Center navigation" });
    expect(within(navigation).getByRole("link", { name: "Command Center" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "Automation Flow" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "Company Details" })).toBeVisible();
    expect(within(navigation).getByRole("button", { name: "More" })).toBeVisible();
  });

  for (const persona of personaNavigation) {
    it(`renders only the authorized records destinations for ${persona.name}`, async () => {
      const user = userEvent.setup();
      setTestPathname(paths[persona.visible[0]]);
      render(
        <DesktopNavigation primary={primaryItems} secondary={navigationItems(persona.visible)} />,
      );
      const navigation = screen.getByRole("navigation", { name: "Command Center navigation" });
      await user.click(within(navigation).getByRole("button", { name: "More" }));
      const visibleLabels = new Set<string>(persona.visible);
      for (const label of persona.visible) {
        expect(within(navigation).getByRole("link", { name: label, exact: true })).toBeVisible();
      }
      for (const label of allLabels.filter((label) => !visibleLabels.has(label))) {
        expect(within(navigation).queryByRole("link", { name: label, exact: true })).toBeNull();
      }
    });
  }
});
