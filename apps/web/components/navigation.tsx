"use client";

import { Badge, MobileNavigation, NavigationLink, SideNavigation } from "@bea/ui";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

import type { CommandCenterNavigationItem } from "@/lib/navigation";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationGlyph({ href }: { href: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (href === "/command-center")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle {...common} cx="12" cy="12" r="7" />
        <circle {...common} cx="12" cy="12" r="2.4" />
      </svg>
    );
  if (href === "/automation-flow")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect {...common} x="3" y="5" width="7" height="5" rx="1.5" />
        <rect {...common} x="14" y="14" width="7" height="5" rx="1.5" />
        <path {...common} d="M10 7.5h4.5V16" />
      </svg>
    );
  if (href === "/company-details")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          {...common}
          d="M4 21V6l8-3v18M12 8h8v13M8 10v.01M8 14v.01M16 12v.01M16 16v.01M2 21h20"
        />
      </svg>
    );
  if (href === "/digital-workforce")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle {...common} cx="12" cy="5" r="2.2" />
        <circle {...common} cx="6" cy="12" r="2.2" />
        <circle {...common} cx="18" cy="12" r="2.2" />
        <path {...common} d="M12 7v3M8 12h8" />
      </svg>
    );
  if (href === "/ai-command")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          {...common}
          d="M12 2 9.8 8.4 3 10.5l6.1 3.4-.2 7.1 5.1-4.8 6.9 2-3-6.4L22 6l-7 .9L12 2Z"
        />
      </svg>
    );
  if (href === "/search")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle {...common} cx="10.5" cy="10.5" r="6.5" />
        <path {...common} d="m16 16 5 5" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...common} x="4" y="4" width="16" height="16" rx="3" />
      <path {...common} d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

function NavigationItems({ items }: { items: readonly CommandCenterNavigationItem[] }) {
  const pathname = usePathname();
  return items.map((item) => (
    <NavigationLink
      key={item.href}
      href={item.href}
      label={item.label}
      icon={<NavigationGlyph href={item.href} />}
      active={isActive(pathname, item.href)}
      badge={item.deferred ? <Badge>Deferred</Badge> : undefined}
    />
  ));
}

export function DesktopNavigation({
  primary,
  secondary,
  items,
}: {
  primary?: readonly CommandCenterNavigationItem[];
  secondary?: readonly CommandCenterNavigationItem[];
  items?: readonly CommandCenterNavigationItem[];
}) {
  const pathname = usePathname();
  const moreId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePath, setMorePath] = useState(pathname);
  const primaryItems = primary ?? [];
  const secondaryItems = secondary ?? items ?? [];
  if (morePath !== pathname) {
    setMorePath(pathname);
    setMoreOpen(false);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCollapsed(window.localStorage.getItem("bea-navigation-collapsed") === "true");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("bea-navigation-collapsed", String(next));
      return next;
    });
  }
  return (
    <div className="bea-navigation-frame" data-collapsed={collapsed ? "true" : "false"}>
      <SideNavigation label="Command Center navigation">
        <div className="bea-primary-nav" data-testid="primary-navigation">
          <NavigationItems items={primaryItems} />
        </div>
        {secondaryItems.length > 0 ? (
          <div className="bea-records-drawer" data-testid="records-drawer">
            <button
              type="button"
              className="bea-navigation-link bea-more-toggle"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className="bea-navigation-link__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M5 7h14M5 12h14M5 17h10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span>More</span>
            </button>
            <div id={moreId} hidden={!moreOpen} className="bea-records-drawer__panel">
              <p className="bea-records-drawer__label">Records and administration</p>
              <NavigationItems items={secondaryItems} />
            </div>
          </div>
        ) : null}
      </SideNavigation>
      <button
        className="bea-navigation-collapse"
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        <span className="bea-navigation-collapse__label">Collapse</span>
      </button>
    </div>
  );
}

export function CompactNavigation({
  primary,
  secondary,
  items,
}: {
  primary?: readonly CommandCenterNavigationItem[];
  secondary?: readonly CommandCenterNavigationItem[];
  items?: readonly CommandCenterNavigationItem[];
}) {
  const primaryItems = primary ?? [];
  const secondaryItems = secondary ?? items ?? [];
  return (
    <MobileNavigation label="Open Command Center navigation">
      <NavigationItems items={primaryItems} />
      {secondaryItems.length > 0 ? (
        <>
          <p className="bea-records-drawer__label">Records and administration</p>
          <NavigationItems items={secondaryItems} />
        </>
      ) : null}
    </MobileNavigation>
  );
}
