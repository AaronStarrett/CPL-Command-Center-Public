import type { ReactNode } from "react";

import { cn } from "./utils";

export interface HeaderProps {
  title?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Header({ title, leading, actions, className }: HeaderProps) {
  return (
    <header className={cn("bea-header", className)}>
      <div className="bea-header__leading">
        {leading}
        {title ? <span className="bea-header__title">{title}</span> : null}
      </div>
      <div className="bea-header__actions">{actions}</div>
    </header>
  );
}

export function SideNavigation({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav className="bea-side-navigation" aria-label={label}>
      {children}
    </nav>
  );
}

export function MobileNavigation({
  label = "Open navigation",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details
      suppressHydrationWarning
      className="bea-mobile-navigation"
      data-testid="mobile-navigation"
    >
      <summary aria-label={label}>
        <span className="bea-menu-icon" aria-hidden="true" />
        <span>Menu</span>
      </summary>
      <nav aria-label="Mobile navigation">{children}</nav>
    </details>
  );
}

export interface NavigationLinkProps {
  href: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: ReactNode;
}

export function NavigationLink({ href, label, icon, active, badge }: NavigationLinkProps) {
  return (
    <a
      className={cn("bea-navigation-link", active && "bea-navigation-link--active")}
      href={href}
      aria-current={active ? "page" : undefined}
    >
      {icon ? <span className="bea-navigation-link__icon">{icon}</span> : null}
      <span>{label}</span>
      {badge ? <span className="bea-navigation-link__badge">{badge}</span> : null}
    </a>
  );
}

export interface ApplicationShellProps {
  logo: ReactNode;
  productName: string;
  navigation: ReactNode;
  mobileNavigation: ReactNode;
  header: ReactNode;
  banner?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function ApplicationShell({
  logo,
  productName,
  navigation,
  mobileNavigation,
  header,
  banner,
  footer,
  children,
}: ApplicationShellProps) {
  return (
    <div className="bea-application-shell">
      <a className="bea-skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="bea-application-shell__topbar">
        <div className="bea-brand-lockup">
          {logo}
          <span>{productName}</span>
        </div>
        <div className="bea-application-shell__header-slot">{header}</div>
        <div className="bea-application-shell__mobile-bar">
          <div className="bea-mobile-brand">{logo}</div>
          {mobileNavigation}
        </div>
      </div>
      <aside className="bea-application-shell__sidebar" data-testid="desktop-navigation">
        {navigation}
        {footer ? <div className="bea-application-shell__sidebar-footer">{footer}</div> : null}
      </aside>
      <div className="bea-application-shell__workspace">
        {banner}
        <main id="main-content" className="bea-main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
