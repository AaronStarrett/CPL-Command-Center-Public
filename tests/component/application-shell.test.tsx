import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import {
  ApplicationShell,
  DemoModeBanner,
  Header,
  MobileNavigation,
  NavigationLink,
  SideNavigation,
} from "../../packages/ui/src/index";

describe("ApplicationShell", () => {
  it("provides landmarks, a skip link, and both responsive navigation surfaces", () => {
    const links = <NavigationLink href="/" label="Command Center" active />;
    render(
      <ApplicationShell
        logo={<span aria-label="Cyber Pirate Labs">BEA</span>}
        productName="Operations Command Center"
        navigation={<SideNavigation label="Primary navigation">{links}</SideNavigation>}
        mobileNavigation={<MobileNavigation>{links}</MobileNavigation>}
        header={<Header title="Command Center" actions={<button>Account</button>} />}
        banner={<DemoModeBanner />}
      >
        <h1>Foundation</h1>
      </ApplicationShell>,
    );

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Foundation" }),
    );
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
    expect(
      screen.getByText("Simulated data and adapters only. No external systems are connected."),
    ).toBeVisible();
  });
});
